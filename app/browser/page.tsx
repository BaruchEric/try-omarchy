import type { Metadata } from "next";
import { DemoLauncher } from "../components/DemoLauncher";

export const metadata: Metadata = {
  title: "Omarchy Browser VM — fully client-side",
  description:
    "Boot the real Omarchy Quattro x86_64 guest entirely in your browser with QEMU and WebAssembly.",
};

export default function BrowserVMPage() {
  return <DemoLauncher />;
}
