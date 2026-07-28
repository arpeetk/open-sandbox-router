"""Python client SDK for Open Sandbox Router.

A thin, dependency-free client over the OSR gateway REST API. Mirrors the TypeScript SDK:
create a sandbox, then run commands/code and read/write files without caring which
provider served it.

    from osr import OSR

    osr = OSR(base_url="http://localhost:8080")
    sbx = osr.create(template="python-3.12", required=["runCode", "filesystem"],
                     routing={"strategy": "cost"})
    sbx.fs_write("/work/data.txt", "hello")
    print(sbx.run("cat", ["/work/data.txt"]).stdout)
    print("ran on:", sbx.provider)
    sbx.destroy()
"""

from .client import OSR, Sandbox, ExecResult, OsrError

__all__ = ["OSR", "Sandbox", "ExecResult", "OsrError"]
