import assert from "node:assert/strict";
import test from "node:test";
import "../src/extractor.js";

const { hasJobDescriptionText, jobrightTitleDetails } = globalThis.ReactiveCaptureExtract;

test("headings and the Jobright skills legend do not count as a description", () => {
	assert.equal(hasJobDescriptionText("Responsibilities\nResponsibilities\n\nQualification\nRepresents the skills you have"), false);
	assert.equal(hasJobDescriptionText("Responsibilities\nQualification\nRequired\nPreferred"), false);
	assert.equal(hasJobDescriptionText("Responsibilities Responsibilities Qualification Represents the skills you have"), false);
});
test("actual responsibilities and requirements pass description checks", () => {
	assert.equal(hasJobDescriptionText("Responsibilities\nDevelop reliable automation pipelines, test model deployments, and investigate production failures.\nRequired\nPython and experience building maintainable software systems."), true);
});
test("Jobright title metadata supplies the company for the currently displayed role", () => {
	const role = "2027 Summer Intern, BS, Waymo ML Ops & Automation";
	assert.deepEqual(jobrightTitleDetails(`${role} @ Waymo | Jobright.ai`, role), { company: "Waymo", role });
});
test("stale SPA title metadata never supplies a different job's company", () => {
	assert.equal(jobrightTitleDetails("Firmware Engineer @ Example Devices | Jobright.ai", "Robotics Engineer"), null);
	assert.equal(jobrightTitleDetails("Careers at Jobright"), null);
	assert.equal(jobrightTitleDetails("Engineer @ Employer | Other website"), null);
});
