import { cBuildArtefacts, createCBuild } from "../../../packages/pgwasm-c/src";

(globalThis as typeof globalThis & { pgwasmCAssetProbe: unknown }).pgwasmCAssetProbe = {
  cBuildArtefacts,
  createCBuild,
};
