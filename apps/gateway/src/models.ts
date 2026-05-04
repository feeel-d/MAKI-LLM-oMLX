export interface GatewayModel {
  id: "gemma-e4b" | "gemma-26b-a4b";
  label: string;
  upstreamModel: string;
  enabled: boolean;
  reason?: string;
}

const defaultModel = process.env.OMLX_DEFAULT_MODEL?.trim() || "gemma-e4b";

export const models: GatewayModel[] = [
  {
    id: "gemma-e4b",
    label: "Gemma E4B",
    upstreamModel: defaultModel,
    enabled: true,
  },
  {
    id: "gemma-26b-a4b",
    label: "Gemma 26B-A4B",
    upstreamModel: "gemma-26b-a4b",
    enabled: false,
    reason: "26B-A4B routing is prepared but not enabled on the oMLX runtime yet.",
  },
];

export function resolveModel(id?: string): GatewayModel {
  const requested = id?.trim() || "gemma-e4b";
  const model = models.find((item) => item.id === requested);
  if (!model) {
    throw Object.assign(new Error(`Unknown model: ${requested}`), { status: 400 });
  }
  if (!model.enabled) {
    throw Object.assign(new Error(model.reason || `${model.label} is unavailable.`), { status: 409 });
  }
  return model;
}
