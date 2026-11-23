import { z } from "zod";

export const lunaModelIdentity = "gpt-6-luna";

/** Terra: the explicit retrieval judge and dreaming's default judge model (ADR-0157, ADR-0190). */
export const terraModelIdentity = "gpt-6.1-terra";

// Persisted assessments from before the model migration remain valid inputs.
export const lunaAssessmentModelSchema = z.enum(["gpt-5.6-luna", lunaModelIdentity]);
