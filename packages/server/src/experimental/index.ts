export type { ExperimentalBulkMutationBackend } from "./mutations/bulk/types";
export { executeDynamicMutation, installDynamicMutationFunction } from "./mutations/bulk/dynamic-strategy";
export {
  executePregeneratedMutation,
  installPregeneratedMutationFunctions,
} from "./mutations/bulk/pregenerated-strategy";
