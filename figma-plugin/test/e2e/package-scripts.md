# E2E: exact commands

    # (a) capture IR — from figma-plugin/, in one terminal:
    python3 test/e2e/serve.py
    # then open http://localhost:8899/harness.html in a browser and wait for
    # "HARNESS CAPTURED fixture-screen ..." / "HARNESS CAPTURED orphaned-screen ..." in the console.

    # (b) run this E2E — from figma-plugin/, in another terminal:
    npx esbuild test/e2e/run.ts --bundle --outfile=test/e2e/run.mjs --format=esm --platform=node --target=node18
    node test/e2e/run.mjs
