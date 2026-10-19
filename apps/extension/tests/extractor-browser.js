// Uses a real browser DOMParser. No fixtures run page scripts or call an API.
const output = document.querySelector("#results");
const results = [];
function assert(condition, message) {
	if (!condition) throw new Error(message);
}
async function fixture(name, url) {
	const response = await fetch(`fixtures/${name}.html`);
	assert(response.ok, `Fixture ${name} failed to load`);
	const doc = new DOMParser().parseFromString(await response.text(), "text/html");
	return globalThis.ReactiveCaptureExtract.extractDocument(doc, { url });
}
const checks = [
	["JSON-LD arrays, @graph, HTML cleanup, requirements and locations", async () => {
		const item = await fixture("jsonld-graph", "https://jobs.example.test/controls/42?utm_source=test");
		assert(item.company === "Example Robotics", "Wrong company");
		assert(item.role === "Controls Engineer", "Wrong role");
		assert(item.extraction === "jsonld", "JSON-LD not used");
		assert(item.canonicalUrl === "https://jobs.example.test/controls/42", "Wrong canonical URL");
		assert(item.location === "Chicago, IL, US; Austin, TX, US", "Wrong locations");
		assert(item.requirements.includes("Python"), "Missing requirement");
		assert(item.description.includes("Test control loops with real hardware."), "Missing HTML description");
		assert(!item.description.includes("window.stolen"), "Script content leaked");
		assert(!item.companyFallback && !item.roleFallback, "Unexpected fallback");
	}],
	["Jobright adapter reads Responsibilities and Qualification sections", async () => {
		const item = await fixture("jobright", "https://jobright.ai/jobs/info/sample-embedded?visit=liked");
		assert(item.extraction === "adapter", "Adapter not used");
		assert(item.company === "Sample Devices" && item.role === "Embedded Engineer", "Wrong details");
		assert(item.description.includes("Required: C, C++"), "Qualification missing");
		assert(item.description.includes("Implement embedded firmware"), "Responsibilities missing");
		assert(!item.description.includes("Apply now"), "Button content leaked");
	}],
	["Generic Greenhouse page preserves posting and strips form/navigation/hidden content", async () => {
		const item = await fixture("greenhouse", "https://boards.greenhouse.io/example/jobs/123?gh_jid=123&utm_campaign=referral");
		assert(item.extraction === "text", "Unexpected extractor");
		assert(item.role === "Software Engineer", "Wrong heading fallback");
		assert(item.companyFallback && item.roleFallback, "Missing uncertainty flags");
		assert(item.description.includes("Build tools for engineers"), "Description missing");
		for (const secret of ["Do not capture", "private@example.test", "Recruiting website"]) assert(!item.description.includes(secret), `Leaked ${secret}`);
		assert(item.canonicalUrl.includes("gh_jid=123") && !item.canonicalUrl.includes("utm_campaign"), "Job identity stripped or tracking retained");
	}],
	["Generic fallback ignores foreign canonical URL and supports selected text", async () => {
		const response = await fetch("fixtures/generic.html");
		const doc = new DOMParser().parseFromString(await response.text(), "text/html");
		const url = "https://careers.example.test/#/jobs/123";
		const item = globalThis.ReactiveCaptureExtract.extractDocument(doc, { url, selection: "Selected job description with useful responsibilities and required technical experience." });
		assert(item.description.startsWith("Selected job description"), "Selection not preferred");
		assert(item.canonicalUrl === url, "Cross-origin canonical accepted or hash identity removed");
		assert(item.warnings.length > 0, "Fallback uncertainty omitted");
	}],
];
for (const [name, run] of checks) {
	try { await run(); results.push(`PASS ${name}`); }
	catch (error) { results.push(`FAIL ${name}: ${error.message}`); }
}
output.textContent = results.join("\n");
document.documentElement.dataset.testResult = results.some((result) => result.startsWith("FAIL")) ? "failed" : "passed";
