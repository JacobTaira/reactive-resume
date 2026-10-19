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
	["Jobright nested heading wrappers include all section bodies and title company", async () => {
		const item = await fixture("jobright-wrapped", "https://jobright.ai/jobs/info/wrapped");
		assert(item.company === "Fictional Mobility", "Company metadata missing");
		assert(item.role === "Automation Intern", "Wrong role");
		assert(item.canonicalUrl === "https://jobright.ai/jobs/info/wrapped", "Wrong canonical identity");
		assert(!item.companyFallback && !item.roleFallback && !item.descriptionIncomplete, "Unexpected incomplete flags");
		for (const text of ["model deployments", "programming in Python", "continuous integration"]) {
			assert(item.description.includes(text), `Section body missing: ${text}`);
		}
		assert(!item.description.includes("Represents the skills you have"), "Skills legend captured");
		assert(!item.description.includes("DO NOT CAPTURE"), "Company/benefits content leaked");
	}],
	["Jobright skill-selection guidance and personalized chips stay out of employer requirements", async () => {
		const item = await fixture("jobright-guidance", "https://jobright.ai/jobs/info/with-skills-ui");
		assert(!item.descriptionIncomplete, "Complete employer sections marked incomplete");
		for (const text of ["Document test results", "Python or C++ fundamentals", "reflect user expertise accurately", "continuous integration"]) {
			assert(item.description.includes(text), `Employer text removed: ${text}`);
		}
		for (const text of ["Find out how your skills align", "If anything seems off", "click on the tags", "Selected-only skill", "Represents the skills you have"]) {
			assert(!item.description.includes(text), `Jobright UI captured: ${text}`);
		}
	}],
	["Jobright loading placeholders remain incomplete instead of storing section labels", async () => {
		const item = await fixture("jobright-loading", "https://jobright.ai/jobs/info/loading");
		assert(item.company === "Fictional Mobility" && item.role === "Automation Intern", "Header metadata missing");
		assert(item.description === "", "Headings-only skeleton treated as description");
		assert(item.descriptionIncomplete, "Missing description uncertainty");
	}],
	["Jobright preserves useful partial content but flags the missing qualifications", async () => {
		const item = await fixture("jobright-partial", "https://jobright.ai/jobs/info/partial");
		assert(item.description.includes("model deployments"), "Available section lost");
		assert(item.descriptionIncomplete, "Missing qualifications were not flagged");
	}],
	["Jobright SPA metadata from another posting never contaminates the current capture", async () => {
		const item = await fixture("jobright-stale", "https://jobright.ai/jobs/info/current-job");
		assert(item.company === "Fictional Mobility" && item.role === "Automation Intern", "Stale metadata used");
		assert(item.canonicalUrl === "https://jobright.ai/jobs/info/current-job", "Stale canonical identity used");
		assert(item.description.includes("model deployments") && !item.description.includes("WRONG JOB"), "Wrong posting description");
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
