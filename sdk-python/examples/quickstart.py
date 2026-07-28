"""Python quickstart. Start the gateway first: `pnpm gateway` (repo root)."""

from osr import OSR


def main() -> None:
    osr = OSR(base_url="http://localhost:8080")

    print("providers:", [p["provider"] for p in osr.providers()])

    plan = osr.route_plan(required=["runCode", "filesystem"], routing={"strategy": "cost"})
    print("would route to:", [c["provider"] for c in plan["candidates"]])

    sbx = osr.create(
        template="python-3.12",
        required=["runCode", "filesystem"],
        routing={"strategy": "cost", "isolationFloor": "microvm"},
    )
    print(f"created {sbx.id} on {sbx.provider}")

    sbx.fs_write("/work/data.txt", "hello sandbox")
    print("cat ->", sbx.run("cat", ["/work/data.txt"]).stdout.strip())

    sbx.destroy()
    print("destroyed")


if __name__ == "__main__":
    main()
