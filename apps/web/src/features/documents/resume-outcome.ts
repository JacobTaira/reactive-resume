import { t } from "@lingui/core/macro";

export const OUTCOME_STAGES = ["not_applied", "applied", "interview", "offer", "rejected", "withdrawn"] as const;
export type OutcomeStage = (typeof OUTCOME_STAGES)[number];

export function outcomeStageLabel(stage: OutcomeStage) {
	switch (stage) {
		case "not_applied":
			return t`Not applied`;
		case "applied":
			return t`Applied`;
		case "interview":
			return t`Interview`;
		case "offer":
			return t`Offer`;
		case "rejected":
			return t`Rejected`;
		case "withdrawn":
			return t`Withdrawn`;
	}
}
