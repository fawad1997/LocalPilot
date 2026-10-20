// Recipe registry. A recipe is a tool backed by fixed code instead of model steps:
//   { definition: {name, description, input_schema}, domains: string[],
//     approval: string | async (ctx, input) => string|null,  // what the user approves
//     promptHint: string,                                      // one line for the system prompt
//     mcp?: false,                                             // hide from MCP clients
//     run(ctx, input) -> content blocks }
// Every recipe needs the PC bridge (they read or write files: the jobs folder, or the trading root).
import boss from './boss.js';
import liepin from './liepin.js';
import job51 from './job51.js';
import zhaopin from './zhaopin.js';
import linkedin from './linkedin.js';
import applyAssist from './apply.js';
import econCalendar from './forexfactory.js';
import news from './news.js';

export const RECIPES = [boss, liepin, job51, zhaopin, linkedin, applyAssist, econCalendar, news];

const byName = new Map(RECIPES.map((r) => [r.definition.name, r]));

export function getRecipe(name) {
  return byName.get(name) || null;
}

export function recipeDefinitions(host) {
  return host ? RECIPES.map((r) => r.definition) : [];
}

export function mcpHiddenRecipes() {
  return RECIPES.filter((r) => r.mcp === false).map((r) => r.definition.name);
}

export function recipePromptLines(host) {
  return host ? RECIPES.map((r) => `- ${r.promptHint}`) : [];
}

export async function recipeApprovalTarget(recipe, ctx, input) {
  return typeof recipe.approval === 'function' ? recipe.approval(ctx, input) : recipe.approval;
}
