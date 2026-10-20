/**
 * "Visual explanations": a system prompt that has the model illustrate
 * explanations with SVG diagrams, which the chat shows as images
 * (components/chat/SvgDiagram.tsx).
 */

export const VISUAL_EXPLANATIONS_PROMPT = `## Diagrams

The chat shows \`\`\`svg code blocks as images and \`\`\`mermaid blocks as diagrams. When a picture explains something better than words (structure, flow, history, state changes, spatial or part-whole relationships, before/after comparisons; e.g. git branches, network architectures, algorithms, data structures), illustrate it. Don't add diagrams to short factual answers, and never draw diagrams with ASCII art.

How to draw:
- Write each diagram as a complete \`\`\`svg block starting with <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 H"> (H as tall as needed, usually 160-400), no width or height attributes, and a <title> naming what it shows.
- One idea per diagram; prefer several small diagrams placed where the text discusses them over one large one.
- Draw for a white background. Shapes: circles and rounded rects (rx 6-8) with 1.5px strokes and soft fills. Pair fills with strokes per group: #EEEDFE/#534AB7 (purple), #E1F5EE/#0F6E56 (green), #FDF0E1/#B05A0E (orange), #F1F1F0/#5F5E5A (gray). Connectors: #888 lines, 1.5px; dashed for virtual or pending links; arrowheads via a <marker> when direction matters.
- Text: font-family="system-ui, sans-serif", 13px for labels and 12px for annotations, text-anchor="middle" in shapes, and an explicit fill on every <text> (the group's stroke color inside shapes, #444 for annotations). Keep labels short and keep everything at least 16px inside the viewBox.
- No scripts, event handlers, external images, fonts or links, and no <foreignObject>.
- After each diagram, write a one-sentence caption as normal text saying what to notice. Keep the explanation in the text; don't refer to "the SVG code".
- For a plain flowchart, sequence or state diagram, a \`\`\`mermaid block is fine instead.`;

/** The global system prompt the desktop sends: the diagram guidance (unless turned off), then the user's own. */
export function withVisualExplanations(systemPrompt: string, enabled: boolean | undefined): string {
  if (enabled === false) return systemPrompt;
  return systemPrompt.trim() ? `${VISUAL_EXPLANATIONS_PROMPT}\n\n${systemPrompt}` : VISUAL_EXPLANATIONS_PROMPT;
}
