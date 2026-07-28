# Deploying OSR

## Kubernetes (self-hosted)

`deploy/kubernetes/gateway.yaml` deploys the gateway into an `osr-system` namespace and
grants it tightly-scoped RBAC to manage sandbox Pods in `osr-sandboxes`.

1. Build and push the gateway image (a Dockerfile/OCI build for `packages/gateway` is on
   the roadmap; until then run the gateway with `pnpm gateway` or your own image).
2. Fill in `osr-provider-creds` with your BYOK provider secrets.
3. Ensure a sandbox isolation runtime is installed on your nodes (gVisor `runsc`, Kata,
   or a Firecracker-backed runtime) and matches the `RuntimeClass` name used by the
   Kubernetes adapter (`gvisor` by default).
4. `kubectl apply -f deploy/kubernetes/gateway.yaml`

With `OSR_K8S_REAL=1`, the Kubernetes adapter provisions each sandbox as a Pod under that
RuntimeClass. Without it, the adapter uses an in-memory simulator (useful for demos).

A Helm chart is planned; `gateway.yaml` is the canonical reference in the meantime.
