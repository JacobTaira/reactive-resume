import type { AnyPgColumn } from "drizzle-orm/pg-core";
import * as pg from "drizzle-orm/pg-core";
import { generateId } from "@reactive-resume/utils/string";
import { user } from "./auth";

export type ResumeProfile = {
	purpose: "general" | "master" | "tailored";
	company: string;
	targetRole: string;
	keywords: string[];
	jobDescription: string;
	jobUrl: string;
	reuseNotes: string;
	score: number | null;
	scoreNotes: string;
	rubric: Array<{ criterion: string; score: number; maxScore: number; notes: string }>;
	evaluatedAt: string | null;
	evaluatedResumeUpdatedAt: string | null;
	requirementEvidence: Array<{
		requirement: string;
		importance: "required" | "preferred";
		status: "supported" | "partial" | "gap";
		evidence: Array<{ resumeId: string; locator: string; quote: string }>;
		notes: string;
	}>;
	tailoringChanges: Array<{ section: string; before: string; after: string; reason: string }>;
	reviewedResumeUpdatedAt: string | null;
	reviewedSourceUpdatedAt: string | null;
	outcome: {
		stage: "not_applied" | "applied" | "interview" | "offer" | "rejected" | "withdrawn";
		notes: string;
		recordedAt: string | null;
		reachedStage: "not_applied" | "applied" | "interview" | "offer";
	};
};

const owned = () => ({
	id: pg.text("id").primaryKey().$defaultFn(() => generateId()),
	userId: pg.text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
	createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: pg.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const resumeFolder = pg.pgTable("resume_folder", {
	...owned(),
	name: pg.text("name").notNull(),
	parentId: pg.text("parent_id").references((): AnyPgColumn => resumeFolder.id, { onDelete: "set null" }),
}, (table) => [pg.index().on(table.userId, table.parentId)]);

export const companyResearch = pg.pgTable("company_research", {
	...owned(),
	company: pg.text("company").notNull(),
	companyKey: pg.text("company_key").notNull(),
	website: pg.text("website").notNull().default(""),
	summary: pg.text("summary").notNull().default(""),
	coreValues: pg.text("core_values").array().notNull().default([]),
	culture: pg.text("culture").notNull().default(""),
	hiringPriorities: pg.text("hiring_priorities").array().notNull().default([]),
	notes: pg.text("notes").notNull().default(""),
	sources: pg.jsonb("sources").notNull().$type<Array<{ url: string; title: string; accessedAt: string; notes: string }>>().default([]),
	revision: pg.integer("revision").notNull().default(1),
}, (table) => [pg.uniqueIndex().on(table.userId, table.companyKey), pg.index().on(table.userId, table.updatedAt.desc())]);
