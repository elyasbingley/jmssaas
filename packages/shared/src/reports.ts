// Dynamic Reports & Safety Documentation Engine - the shape of
// report_templates.structure_schema (the form definition an admin builds
// in Template Studio) and report_instances.form_data (the answers a user
// fills in when executing that form). Neither is validated by Postgres
// (both are plain jsonb, same "no fixed columns for a form-builder JSON
// blob" tradeoff property_assets.attributes already makes) - zod schemas
// in schemas.ts validate the outer shape at the app boundary; the field-
// type-specific answer shape is enforced by the form runner UI itself,
// which only ever writes the ReportAnswer variant matching a field's
// declared type.

export type ReportFieldType = "pass_fail" | "risk_matrix" | "photo" | "text" | "long_text" | "meter_reading" | "signature";

export interface ReportFieldDefinition {
  id: string;
  type: ReportFieldType;
  label: string;
  required: boolean;
  helpText?: string;
  // pass_fail only - if true, answering "fail" reveals a mandatory
  // action-note + photo sub-question (Workflow 1's conditional logic).
  requireActionOnFail?: boolean;
}

export interface ReportSectionDefinition {
  id: string;
  title: string;
  fields: ReportFieldDefinition[];
}

export type ReportStructureSchema = ReportSectionDefinition[];

// ---------------------------------------------------------------------------
// Answers - report_instances.form_data is a Record<fieldId, ReportAnswer>.
// Photo paths are storage object paths within the "report-files" bucket
// (not full URLs), same convention as job_files.storage_path - resolved to
// a signed URL at render/PDF-compile time, never stored as one.
// ---------------------------------------------------------------------------

export type PassFailValue = "pass" | "fail" | "na";

export interface PassFailAnswer {
  type: "pass_fail";
  value: PassFailValue;
  actionNote?: string;
  actionPhotoPaths?: string[];
}

// Standard 5x5 WHS risk matrix bands (AS/NZS ISO 31000-style) - the
// common shape most SWMS/JSA templates use, not something invented for
// this app.
export type RiskLikelihood = 1 | 2 | 3 | 4 | 5;
export type RiskConsequence = 1 | 2 | 3 | 4 | 5;
export type RiskRating = "low" | "medium" | "high" | "extreme";

export interface RiskMatrixAnswer {
  type: "risk_matrix";
  likelihood: RiskLikelihood;
  consequence: RiskConsequence;
  rating: RiskRating;
}

export interface PhotoAnswer {
  type: "photo";
  photoPaths: string[];
}

export interface TextAnswer {
  type: "text";
  value: string;
}

export interface LongTextAnswer {
  type: "long_text";
  value: string;
}

export interface MeterReadingAnswer {
  type: "meter_reading";
  value: string;
}

export interface SignatureAnswer {
  type: "signature";
  signerName: string;
  svgData: string;
}

export type ReportAnswer =
  | PassFailAnswer
  | RiskMatrixAnswer
  | PhotoAnswer
  | TextAnswer
  | LongTextAnswer
  | MeterReadingAnswer
  | SignatureAnswer;

export type ReportFormData = Record<string, ReportAnswer>;

export const RISK_LIKELIHOOD_LABELS: Record<RiskLikelihood, string> = {
  1: "Rare",
  2: "Unlikely",
  3: "Possible",
  4: "Likely",
  5: "Almost Certain",
};

export const RISK_CONSEQUENCE_LABELS: Record<RiskConsequence, string> = {
  1: "Insignificant",
  2: "Minor",
  3: "Moderate",
  4: "Major",
  5: "Catastrophic",
};

export const RISK_RATING_LABELS: Record<RiskRating, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  extreme: "Extreme",
};

// score = likelihood x consequence (1-25), banded into 4 ratings.
export function calculateRiskRating(likelihood: RiskLikelihood, consequence: RiskConsequence): RiskRating {
  const score = likelihood * consequence;
  if (score >= 15) return "extreme";
  if (score >= 8) return "high";
  if (score >= 4) return "medium";
  return "low";
}

export const FIELD_TYPE_LABELS: Record<ReportFieldType, string> = {
  pass_fail: "Pass / Fail / N/A",
  risk_matrix: "Risk Assessment Matrix",
  photo: "Photo Capture",
  text: "Short Text",
  long_text: "Long Answer",
  meter_reading: "Meter Reading",
  signature: "E-Signature",
};

// A blank answer for a freshly-rendered field - what the form runner
// initializes form_data[field.id] to before the user interacts with it.
export function blankAnswerFor(type: ReportFieldType): ReportAnswer {
  switch (type) {
    case "pass_fail":
      return { type: "pass_fail", value: "na" };
    case "risk_matrix":
      return { type: "risk_matrix", likelihood: 1, consequence: 1, rating: calculateRiskRating(1, 1) };
    case "photo":
      return { type: "photo", photoPaths: [] };
    case "text":
      return { type: "text", value: "" };
    case "long_text":
      return { type: "long_text", value: "" };
    case "meter_reading":
      return { type: "meter_reading", value: "" };
    case "signature":
      return { type: "signature", signerName: "", svgData: "" };
  }
}

// "Answered" for required-field validation - deliberately permissive per
// type (e.g. a pass_fail answered 'na' still counts as answered; only an
// empty photoPaths/svgData/value counts as unanswered).
export function isAnswered(answer: ReportAnswer | undefined): boolean {
  if (!answer) return false;
  switch (answer.type) {
    case "pass_fail":
      return true;
    case "risk_matrix":
      return true;
    case "photo":
      return answer.photoPaths.length > 0;
    case "text":
    case "long_text":
    case "meter_reading":
      return answer.value.trim().length > 0;
    case "signature":
      return answer.svgData.trim().length > 0 && answer.signerName.trim().length > 0;
  }
}
