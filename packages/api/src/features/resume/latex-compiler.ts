import type { LatexCompileOptions, LatexProject } from "@reactive-resume/schema/resume/latex";
import { ORPCError } from "@orpc/server";
import { env } from "@reactive-resume/env/server";
import { latexCompileOptionsSchema, latexCompileResultSchema, latexProjectSchema } from "@reactive-resume/schema/resume/latex";

const MAX_RESPONSE_BYTES = 18 * 1024 * 1024;

/** The destination is operator-configured; request data can never choose a compiler URL. */
export async function requestLatexWorker(path: "compile" | "unpack", input: unknown): Promise<unknown> {
	if (!env.LATEX_COMPILER_URL || !env.LATEX_COMPILER_TOKEN) {
		throw new ORPCError("SERVICE_UNAVAILABLE", { message: "LaTeX compilation is not configured. Start the LaTeX service and set LATEX_COMPILER_URL and LATEX_COMPILER_TOKEN." });
	}
	try {
		const response = await fetch(`${env.LATEX_COMPILER_URL.replace(/\/$/, "")}/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${env.LATEX_COMPILER_TOKEN}` },
			body: JSON.stringify(input),
			// Includes the worker queue, two TeX passes, and bounded local PDF inspection.
			signal: AbortSignal.timeout(90_000),
			redirect: "error",
		});
		if (!response.ok) {
			throw new ORPCError(response.status === 400 || response.status === 413 ? "BAD_REQUEST" : "SERVICE_UNAVAILABLE", {
				message: response.status === 503 ? "The LaTeX compiler is busy. Try again shortly." : "The LaTeX compiler rejected the project or is unavailable.",
			});
		}
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing compiler response");
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > MAX_RESPONSE_BYTES) throw new Error("Compiler response is too large");
				chunks.push(value);
			}
		} finally {
			await reader.cancel();
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
	} catch (error) {
		if (error instanceof ORPCError) throw error;
		throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Could not reach the LaTeX compiler. Check that its service is running." });
	}
}

export async function compileLatexProject(project: LatexProject, options: LatexCompileOptions = {}) {
	const input = latexProjectSchema.parse(project);
	const compileOptions = latexCompileOptionsSchema.parse(options);
	return latexCompileResultSchema.parse(await requestLatexWorker("compile", { ...input, ...compileOptions }));
}

export async function unpackLatexArchive(archive: string) {
	return latexProjectSchema.parse(await requestLatexWorker("unpack", { archive }));
}
