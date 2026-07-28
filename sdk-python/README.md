# osr-sdk (Python)

Dependency-free Python client for the Open Sandbox Router gateway. Mirrors the
TypeScript SDK over the same REST contract (`openapi/openapi.yaml`).

```python
from osr import OSR

osr = OSR(base_url="http://localhost:8080")

sbx = osr.create(
    template="python-3.12",
    required=["runCode", "filesystem"],
    routing={"strategy": "cost", "isolationFloor": "microvm"},
)
sbx.fs_write("/work/data.txt", "hello")
print(sbx.run("cat", ["/work/data.txt"]).stdout)   # -> hello
print("ran on provider:", sbx.provider)
sbx.destroy()
```

Start the gateway first (`pnpm gateway` from the repo root).
