export interface ExactCompactAssessment {
  readonly text: string;
  readonly renderedTokenCount: number;
  readonly validated: boolean;
}

function tokenEstimate(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

/**
 * An exact body copy needs no model judgement when it is already compact and
 * contains every separately-declared semantic qualifier. Longer or lossy
 * representations remain unvalidated for background representation repair.
 */
export function assessExactCompact(request: {
  readonly body: string;
  readonly conditions: readonly string[];
  readonly exclusions: readonly string[];
  readonly preservedNegations: readonly string[];
  readonly maximumTokens?: number;
}): ExactCompactAssessment {
  const text = request.body.trim();
  const renderedTokenCount = tokenEstimate(text);
  const normalizedText = normalize(text);
  const qualifiers = [
    ...request.conditions,
    ...request.exclusions,
    ...request.preservedNegations
  ].map(normalize).filter((value) => value.length > 0);
  return {
    text,
    renderedTokenCount,
    validated:
      text.length > 0 &&
      renderedTokenCount <= (request.maximumTokens ?? 96) &&
      qualifiers.every((qualifier) => normalizedText.includes(qualifier))
  };
}
