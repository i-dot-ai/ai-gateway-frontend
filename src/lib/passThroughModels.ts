import type { LitellmModel } from "./litellm";
import { GATEWAY_BASE_URL } from "./opencode";

/**
 * Services the gateway serves through a pass-through route rather than its
 * model_list, so /v2/model/info never returns them. Listing them here gives them
 * the normal model page (getModel() falls back to this list). Their spend is
 * logged under the name the provider reports (e.g. "typesafe/jev-1.13.0"), not
 * the alias, so usage matches on `usagePrefix`.
 *
 * A service with `endpoints` is a tool rather than a model (Tavily): its page
 * shows the endpoints and an example call instead of model-only details.
 */
export interface PassThroughModel extends LitellmModel {
	passThrough: {
		/** Gateway route callers use, e.g. "/typesafe/". */
		route: string;
		/** Prefix of this service's `model_groups` names in the daily activity. */
		usagePrefix: string;
		/** Tools only: the endpoints under `route`, and an example call. */
		endpoints?: ReadonlyArray<string>;
		example?: string;
	};
}

const GATEWAY_ORIGIN = new URL(GATEWAY_BASE_URL).origin;

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
	{
		id: "tavily",
		name: "Tavily",
		provider: "Tavily",
		mode: "search",
		litellm_model: "tavily",
		supports_vision: false,
		supports_function_calling: false,
		supports_audio_input: false,
		supports_reasoning: false,
		lab: "Tavily",
		uri: "https://docs.tavily.com",
		description:
			"Tavily's web search and extraction API, for grounding answers in current sources. Search returns ranked results for a query; extract returns the text of given web pages.",
		passThrough: {
			route: "/tavily/",
			// Unverified: what the activity data records for /tavily calls, if anything.
			usagePrefix: "tavily",
			endpoints: ["/tavily/search", "/tavily/extract"],
			example: `curl ${GATEWAY_ORIGIN}/tavily/search \\
  -H "Authorization: Bearer $GATEWAY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "AI in government guidance", "max_results": 5}'`,
		},
	},
];

export function isPassThrough(model: LitellmModel): model is PassThroughModel {
	return "passThrough" in model;
}

/** A pass-through tool (one that lists endpoints) rather than something called like a model. */
export function isPassThroughTool(model: LitellmModel): boolean {
	return isPassThrough(model) && Boolean(model.passThrough.endpoints);
}

/** The models and services list: the gateway's models plus every pass-through service. */
export function withPassThrough(models: ReadonlyArray<LitellmModel>): LitellmModel[] {
	return [...models, ...PASS_THROUGH_MODELS];
}
