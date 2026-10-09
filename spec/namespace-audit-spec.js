const { spawnSync } = require("node:child_process");
const path = require("node:path");

describe("Variables generated Python namespace", () => {
  it("keeps an existing user helper and all namespace keys while reporting ordinary values", async () => {
    for (const method of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    const python =
      process.env.LUMINE_TEST_PYTHON || (process.platform === "win32" ? null : "python3");
    if (!python) return pending("Set LUMINE_TEST_PYTHON to an owned Python executable on Windows.");
    const pack = await lumine.packages.activatePackage("jupyter-variables");
    const { VARIABLES_CODE } = require(path.join(pack.path, "lib/variables-store"));
    const script = `import base64, builtins, contextlib, io, json, sys
old = lambda: 'owned original helper'
for runtime in (builtins,builtins.__dict__):
    namespace = {'answer':42, 'exec':'owned ordinary value', '_get_variables':old,'__builtins__':runtime}
    before=set(namespace)
    output=io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(compile(base64.b64decode(sys.argv[1]).decode('utf-8'), '<owned-variables>', 'exec'), namespace)
    assert namespace.get('_get_variables') is old, 'existing private user helper was changed'
    assert set(namespace)==before, 'namespace keys were changed'
    assert namespace['__builtins__'] is runtime
    values=json.loads(output.getvalue())
    assert {'answer','exec'} <= {value['name'] for value in values}
print('completed owned namespace control')
`;
    const result = spawnSync(
      python,
      ["-S", "-c", script, Buffer.from(VARIABLES_CODE).toString("base64")],
      {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      },
    );
    expect(result.error).withContext(result.error?.message).toBeUndefined();
    expect(result.status).withContext(result.stderr).toBe(0);
    expect(result.stdout).toContain("completed owned namespace control");
    await lumine.packages.deactivatePackage("jupyter-variables");
  });
});
