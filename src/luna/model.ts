import { z } from "zod";

export const lunaModelIdentity = "gpt-6-luna";

// Persisted assessments from before the model migration remain valid inputs.
export const lunaAssessmentModelSchema = z.enum(["gpt-5.6-luna", lunaModelIdentity]);
