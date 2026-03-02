/**
 * Shared type for tool definitions.
 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
