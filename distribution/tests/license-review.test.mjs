import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  generateLicenseReviewSkeleton,
  serializeLicenseReviewSkeleton,
} from "../license-review.mjs";

const execFileAsync = promisify(execFile);
const fixtureRoot = fileURLToPath(new URL("fixtures/rootfs", import.meta.url));
const reviewCommand = fileURLToPath(new URL("../license-review.mjs", import.meta.url));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packageDescription({ name, version = "1.0.0-1", base = name, licenses }) {
  const sections = [
    ["NAME", [name]],
    ["BASE", [base]],
    ["VERSION", [version]],
    ["DESC", [`License review fixture for ${name}`]],
    ["URL", [`https://example.test/${name}`]],
    ["ARCH", ["x86_64"]],
  ];
  if (licenses !== undefined) sections.push(["LICENSE", licenses]);
  return `${sections.map(([key, values]) => `%${key}%\n${values.join("\n")}`).join("\n\n")}\n`;
}

async function writePackage(rootfs, options) {
  const contents = packageDescription(options);
  const directory = path.join(
    rootfs,
    "var/lib/pacman/local",
    `${options.name}-${options.version ?? "1.0.0-1"}`,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "desc"), contents);
  return contents;
}

async function makeReviewFixture(context) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "omarchy-license-review-test-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const rootfs = path.join(temporary, "rootfs-one");
  await cp(fixtureRoot, rootfs, { recursive: true });

  const demoDesc = path.join(
    rootfs,
    "var/lib/pacman/local/demo-lib-1.2.3-1/desc",
  );
  await writeFile(demoDesc, (await readFile(demoDesc, "utf8")).replace("%LICENSE%\nMIT", "%LICENSE%\ncustom"));
  await writePackage(rootfs, {
    name: "shared-one",
    base: "shared-base",
    licenses: ["MIT", "Apache-2.0"],
  });
  await writePackage(rootfs, {
    name: "shared-two",
    base: "shared-base",
    licenses: ["MIT", "Apache-2.0"],
  });
  await writePackage(rootfs, { name: "missing-license" });
  await writePackage(rootfs, { name: "doc-license", licenses: ["custom"] });

  await mkdir(path.join(rootfs, "usr/share/licenses/shared-base"), { recursive: true });
  await writeFile(
    path.join(rootfs, "usr/share/licenses/shared-base/COPYING"),
    "shared candidate text\n",
  );
  await mkdir(path.join(rootfs, "usr/share/licenses/doc-license"), { recursive: true });
  await mkdir(path.join(rootfs, "usr/share/doc/doc-license"), { recursive: true });
  await writeFile(
    path.join(rootfs, "usr/share/doc/doc-license/COPYING"),
    "documentation candidate text\n",
  );
  await symlink(
    "/usr/share/doc/doc-license/COPYING",
    path.join(rootfs, "usr/share/licenses/doc-license/LICENSE"),
  );
  return { temporary, rootfs };
}

function allPackages(report) {
  return report.declarationGroups.flatMap((group) => group.packages);
}

test("emits a deterministic fail-closed skeleton grouped by exact pacman declarations", async (context) => {
  const fixture = await makeReviewFixture(context);
  const copy = path.join(fixture.temporary, "rootfs-two");
  await cp(fixture.rootfs, copy, { recursive: true });

  const first = await generateLicenseReviewSkeleton(fixture.rootfs);
  const second = await generateLicenseReviewSkeleton(copy);
  assert.deepEqual(second, first);
  assert.equal(serializeLicenseReviewSkeleton(second), serializeLicenseReviewSkeleton(first));
  assert.equal(serializeLicenseReviewSkeleton(first).includes(fixture.temporary), false);

  assert.equal(first.documentType, "omarchy-package-license-review-skeleton");
  assert.equal(first.legalStatus, "NOT_CLEARED");
  assert.equal(first.reviewStatus, "TODO");
  assert.equal(first.generatedConclusions, 0);
  assert.deepEqual(first.summary, {
    installedPackageCount: 6,
    packagesResolvedByBuilderDefaults: 1,
    packagesRequiringReview: 5,
    rawDeclarationGroupsRequiringReview: 3,
    packagesWithoutInstalledLicenseFileCandidates: 1,
  });
  assert.deepEqual(first.packagesWithoutInstalledLicenseFileCandidates, ["missing-license"]);

  const emptyGroup = first.declarationGroups.find(
    (group) => group.rawPacmanLicenseDeclarations.length === 0,
  );
  assert.equal(emptyGroup.unresolvedReason.code, "MISSING_PACMAN_LICENSE_DECLARATION");
  assert.deepEqual(emptyGroup.packages[0].rawPacmanLicenseDeclarations, []);

  const sharedGroup = first.declarationGroups.find(
    (group) => JSON.stringify(group.rawPacmanLicenseDeclarations) === JSON.stringify(["MIT", "Apache-2.0"]),
  );
  assert.equal(sharedGroup.packageCount, 2);
  assert.deepEqual(sharedGroup.packages.map((item) => item.name), ["shared-one", "shared-two"]);
  assert.deepEqual(
    sharedGroup.packages[0].licenseFileSearchPaths,
    ["usr/share/licenses/shared-base", "usr/share/licenses/shared-one"],
  );
  assert.deepEqual(sharedGroup.packages[0].licenseFileCandidates, [{
    path: "usr/share/licenses/shared-base/COPYING",
    resolvedPath: "usr/share/licenses/shared-base/COPYING",
    bytes: Buffer.byteLength("shared candidate text\n"),
    sha256: sha256("shared candidate text\n"),
    symlinks: [],
  }]);

  const packages = allPackages(first);
  assert.equal(packages.some((item) => item.name === "linux"), false);
  for (const item of packages) {
    assert.deepEqual(item.review, {
      status: "TODO",
      concluded: null,
      licenseFiles: null,
      notes: "TODO: record a package-specific human review; do not infer a conclusion from filenames.",
    });
  }

  const docLicense = packages.find((item) => item.name === "doc-license");
  assert.deepEqual(docLicense.rawPacmanLicenseDeclarations, ["custom"]);
  assert.deepEqual(docLicense.licenseFileCandidates, [{
    path: "usr/share/licenses/doc-license/LICENSE",
    resolvedPath: "usr/share/doc/doc-license/COPYING",
    bytes: Buffer.byteLength("documentation candidate text\n"),
    sha256: sha256("documentation candidate text\n"),
    symlinks: [{
      path: "usr/share/licenses/doc-license/LICENSE",
      target: "/usr/share/doc/doc-license/COPYING",
    }],
  }]);
  assert.match(docLicense.pacmanMetadata.path, /^var\/lib\/pacman\/local\//);
  assert.match(docLicense.pacmanMetadata.sha256, /^[0-9a-f]{64}$/);
  assert.match(first.inputFingerprints.packageMetadataSha256, /^[0-9a-f]{64}$/);
  assert.match(first.inputFingerprints.candidateLicenseFilesSha256, /^[0-9a-f]{64}$/);
});

test("CLI writes a new deterministic report and refuses to overwrite it", async (context) => {
  const fixture = await makeReviewFixture(context);
  const output = path.join(fixture.temporary, "review.todo.json");
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [reviewCommand, "--output", output, "--rootfs", fixture.rootfs],
    { encoding: "utf8" },
  );
  assert.equal(stderr, "");
  assert.match(stdout, /5 packages in 3 raw-declaration groups; legal clearance: required/);
  assert.deepEqual(
    JSON.parse(await readFile(output, "utf8")),
    await generateLicenseReviewSkeleton(fixture.rootfs),
  );

  await assert.rejects(
    execFileAsync(process.execPath, [reviewCommand, "--rootfs", fixture.rootfs, "--output", output]),
    (error) => error.code === 1 && /EEXIST|file already exists/.test(error.stderr),
  );
});

test("fails closed when a candidate license symlink escapes reviewed guest roots", async (context) => {
  const fixture = await makeReviewFixture(context);
  const license = path.join(fixture.rootfs, "usr/share/licenses/demo-lib/LICENSE");
  await unlink(license);
  await symlink("/etc/passwd", license);
  await assert.rejects(
    generateLicenseReviewSkeleton(fixture.rootfs),
    /license symlink escapes reviewed guest roots/,
  );
});
