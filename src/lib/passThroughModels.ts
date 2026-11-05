import type { LitellmModel } from "./litellm";

/**
 * Models the gateway serves through a pass-through route rather than its
 * model_list, so /v2/model/info never returns them. Listing them here gives them
 * the normal model page (getModel() falls back to this list). Their spend is
 * logged under the name the provider reports (e.g. "typesafe/jev-1.13.0"), not
 * the alias, so usage matches on `usagePrefix`.
 */
export interface PassThroughModel extends LitellmModel {
	passThrough: {
		/** Gateway route callers use, e.g. "/typesafe/". */
		route: string;
		/** Prefix of this model's `model_groups` names in the daily activity. */
		usagePrefix: string;
	};
}

export const PASS_THROUGH_MODELS: ReadonlyArray<PassThroughModel> = [
	{
		id: "jev",
		name: "jev-latest",
		provider: "TypeSafe",
		mode: "decision",
		litellm_model: "typesafe/jev-latest",
		location: "US",
		supports_vision: false,
		supports_function_calling: false,
		supports_audio_input: false,
		supports_reasoning: false,
		lab: "TypeSafe",
		country_of_origin: "US",
		open_weight: false,
		// $0.042 per 1M input tokens, no output charge (llm-prices.com / TypeSafe).
		input_cost_per_token: 0.000000042,
		output_cost_per_token: 0,
		uri: "https://docs.typesafe.ai/api",
		description:
			"TypeSafe's decision model. Instead of writing text, it returns a choice, a score or a yes/no probability, for classifying, routing or answering structured questions about some text.",
		passThrough: {
			route: "/typesafe/",
			usagePrefix: "typesafe/jev-",
		},
	},
];

export function isPassThrough(model: LitellmModel): model is PassThroughModel {
	return "passThrough" in model;
}
