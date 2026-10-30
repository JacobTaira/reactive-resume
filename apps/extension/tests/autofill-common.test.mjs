import assert from "node:assert/strict";
import test from "node:test";
import { COMMON_ANSWER_FIELDS, approvedCommonAnswers } from "../src/autofill-common.js";

test("common answers are all manual until explicitly approved", () => {
	const defaults = approvedCommonAnswers();
	assert.equal(Object.keys(defaults).length, 5);
	assert.ok(Object.values(defaults).every((value) => value === ""));
	assert.deepEqual(approvedCommonAnswers({}), defaults);
});

test("common answers whitelist fields and preserve exact approved meanings", () => {
	const input = { jobSource: "  Personal search  ", priorGovernmentEmployment: "No", gender: "Decline to self-identify", race: "Asian (Not Hispanic or Latino)", protectedVeteranStatus: "I am not a protected veteran", apiKey: "not-an-answer" };
	const result = approvedCommonAnswers(input);
	assert.equal(result.jobSource, "Personal search");
	assert.equal(result.race, input.race);
	assert.equal(result.protectedVeteranStatus, input.protectedVeteranStatus);
	assert.equal("apiKey" in result, false);
	assert.equal(result.priorGovernmentEmployment, "No");
});

test("unsupported demographic or screening choices cannot silently become approved values", () => {
	for (const field of COMMON_ANSWER_FIELDS.filter((item) => item.choices)) {
		assert.throws(() => approvedCommonAnswers({ [field.key]: "guessed value" }), /Choose a supported/);
		for (const value of field.choices) assert.equal(approvedCommonAnswers({ [field.key]: value })[field.key], value);
	}
	assert.throws(() => approvedCommonAnswers([]), /must be an object/);
	assert.throws(() => approvedCommonAnswers(null), /must be an object/);
});
