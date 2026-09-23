import { describe, it } from "node:test";
import { expectAll } from "./test-helpers.ts";

describe("helm", () => {
	it("allows inspection and local chart work", () =>
		expectAll("allow", [
			"helm version",
			"helm list -A",
			"helm ls -n app",
			"helm status api -n app",
			"helm history api -n app",
			"helm search repo nginx",
			"helm search hub prometheus",
			"helm show values bitnami/redis",
			"helm show chart ./chart",
			"helm template api ./chart -f values.yaml",
			"helm template api ./chart --kube-context stoik-product-prod",
			"helm lint ./chart",
			"helm pull bitnami/redis --untar",
			"helm package ./chart",
			"helm create newchart",
			"helm repo list",
			"helm repo add bitnami https://charts.bitnami.com/bitnami",
			"helm repo update",
			"helm dependency update ./chart",
			"helm dep build ./chart",
			"helm plugin list",
			"helm env",
		]));

	it("asks for helm get and unknown commands", () =>
		expectAll("ask", [
			"helm get values api -n app",
			"helm get manifest api",
			"helm get all api",
			"helm diff upgrade api ./chart",
			"helm secrets view x",
		]));

	it("denies release mutations and overrides", () =>
		expectAll("deny", [
			"helm install api ./chart -n app",
			"helm upgrade --install api ./chart",
			"helm upgrade api ./chart -f values.yaml --atomic",
			"helm uninstall api -n app",
			"helm delete api",
			"helm rollback api 3",
			"helm test api",
			"helm push chart.tgz oci://registry",
			"helm registry login registry.example.com",
			"helm repo remove bitnami",
			"helm plugin install https://x",
			"helm template api ./chart --post-renderer ./kustomize.sh",
			"helm list --kubeconfig ~/.kube/config",
			"KUBECONFIG=/tmp/kc helm list",
			"helm list --kube-as-user admin",
			"helm template api ./chart | kubectl apply -f -",
		]));
});
