export const COMMON_ANSWER_FIELDS = [
	{ key: "jobSource", label: "Default job discovery source", type: "text", hint: "For example, a job board or your own search. Reuse only when this source applies; review it for each job." },
	{ key: "priorGovernmentEmployment", label: "Prior government employment", choices: ["Yes", "No"], hint: "Only for questions about previous government employment. Current, federal-only or family employment questions remain separate." },
	{ key: "gender", label: "Gender", choices: ["Male", "Female", "Non-binary", "Decline to self-identify"], hint: "Used only for recognized gender questions, not sex assigned at birth." },
	{ key: "race", label: "Race / ethnicity for combined U.S. EEO questions", choices: ["Hispanic or Latino", "White (Not Hispanic or Latino)", "Black or African American (Not Hispanic or Latino)", "Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)", "Asian (Not Hispanic or Latino)", "American Indian or Alaska Native (Not Hispanic or Latino)", "Two or More Races (Not Hispanic or Latino)", "Decline to self-identify"], hint: "Choose only the category you want reused. Separate ethnicity questions and checkbox multi-select groups remain manual." },
	{ key: "protectedVeteranStatus", label: "Protected veteran status", choices: ["I identify as a protected veteran", "I am not a protected veteran", "I decline to self-identify for protected veteran status"], hint: "Protected-veteran status does not establish whether you have ever served. General military-service questions remain separate." },
];

export function approvedCommonAnswers(input = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Common answers must be an object.");
	return Object.fromEntries(COMMON_ANSWER_FIELDS.map((field) => {
		const value = typeof input[field.key] === "string" ? input[field.key].trim().slice(0, 500) : "";
		if (value && field.choices && !field.choices.includes(value)) throw new Error(`Choose a supported ${field.label.toLowerCase()} answer, or leave it manual.`);
		return [field.key, value];
	}));
}
