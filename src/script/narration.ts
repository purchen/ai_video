import { scriptDocumentSchema, type ScriptDocument } from '../domain/schemas';

export function scriptNarrationText(input: unknown): string {
  const script = scriptDocumentSchema.parse(input);
  const errors = narrationBindingErrors(script);
  if (errors.length > 0) throw new Error(errors.join('; '));

  const sentenceById = new Map(script.sentences.map((sentence) => [sentence.id, sentence]));
  return script.sections
    .map((section) => section.sentenceIds.map((sentenceId) => sentenceById.get(sentenceId)!.text).join('\n'))
    .join('\n\n');
}

export function narrationBindingErrors(script: ScriptDocument): string[] {
  const errors: string[] = [];
  const sentenceById = new Map<string, ScriptDocument['sentences'][number]>();
  for (const sentence of script.sentences) {
    if (sentenceById.has(sentence.id)) errors.push(`duplicate script sentence id ${sentence.id}`);
    sentenceById.set(sentence.id, sentence);
  }

  const referenced = new Set<string>();
  for (const section of script.sections) {
    for (const sentenceId of section.sentenceIds) {
      if (!sentenceById.has(sentenceId)) {
        errors.push(`section ${section.type} references unknown sentence ${sentenceId}`);
      } else if (referenced.has(sentenceId)) {
        errors.push(`sentence ${sentenceId} is referenced more than once`);
      }
      referenced.add(sentenceId);
    }
  }

  for (const sentence of script.sentences) {
    if (!referenced.has(sentence.id)) errors.push(`sentence ${sentence.id} is not referenced by any section`);
  }
  return [...new Set(errors)];
}
