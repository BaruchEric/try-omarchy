.DEFAULT_GOAL := test

.PHONY: check test

check:
	node --check archive.mjs
	node --check licenses.mjs
	node --check build.mjs
	npx eslint .

test:
	node --test tests/*.test.mjs
