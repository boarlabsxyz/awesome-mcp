// scripts/peopleforce-smoke.ts
// Ad-hoc live check for PeopleForce MCP tools WITHOUT wiring the MCP into Claude.
// It calls PeopleForceClient (the same client the tools use) against the real API
// and prints the exact formatter output a tool would return.
//
// Usage:
//   PEOPLEFORCE_API_KEY=xxxxx npx tsx scripts/peopleforce-smoke.ts <command> [arg]
//
// Examples:
//   PEOPLEFORCE_API_KEY=xxx npx tsx scripts/peopleforce-smoke.ts listEmployees
//   PEOPLEFORCE_API_KEY=xxx npx tsx scripts/peopleforce-smoke.ts getEmployee 12345
//   PEOPLEFORCE_API_KEY=xxx npx tsx scripts/peopleforce-smoke.ts listObjectives
//   PEOPLEFORCE_API_KEY=xxx npx tsx scripts/peopleforce-smoke.ts listKeyPerformanceIndicators
//   PEOPLEFORCE_API_KEY=xxx npx tsx scripts/peopleforce-smoke.ts listKnowledgeBaseCategories
//   PEOPLEFORCE_API_KEY=xxx npx tsx scripts/peopleforce-smoke.ts listKnowledgeBaseArticles <categoryId>
//   PEOPLEFORCE_API_KEY=xxx npx tsx scripts/peopleforce-smoke.ts getKnowledgeBaseArticle <articleId>
//   PEOPLEFORCE_API_KEY=xxx npx tsx scripts/peopleforce-smoke.ts raw getEmployee 12345   # dump raw JSON
//
// Optional: PEOPLEFORCE_BASE_URL to point at a non-default tenant/base.

import {
  PeopleForceClient,
  formatEmployeeList,
  formatEmployee,
  formatObjectiveList,
  formatKpiList,
  formatKnowledgeCategoryList,
  formatKnowledgeArticleList,
  formatKnowledgeArticle,
} from '../src/peopleforce/apiHelpers.js';

const token = process.env.PEOPLEFORCE_API_KEY;
if (!token) {
  console.error('Set PEOPLEFORCE_API_KEY. e.g. PEOPLEFORCE_API_KEY=xxx npx tsx scripts/peopleforce-smoke.ts listObjectives');
  process.exit(1);
}

const client = new PeopleForceClient(token, process.env.PEOPLEFORCE_BASE_URL);

const [cmd, ...rest] = process.argv.slice(2);

// `raw <command> [arg]` dumps the untouched JSON so you can confirm real wire shapes.
const raw = cmd === 'raw';
const command = raw ? rest[0] : cmd;
const arg = raw ? rest[1] : rest[0];

async function run(): Promise<string> {
  switch (command) {
    case 'listEmployees': {
      const r = await client.listEmployees({ page: arg ? Number(arg) : 1 });
      return raw ? JSON.stringify(r, null, 2) : formatEmployeeList(r.data ?? [], r.metadata?.pagination);
    }
    case 'getEmployee': {
      const r = await client.getEmployee(arg);
      return raw ? JSON.stringify(r, null, 2) : formatEmployee(r.data);
    }
    case 'listObjectives': {
      const r = await client.listObjectives({ page: arg ? Number(arg) : 1 });
      return raw ? JSON.stringify(r, null, 2) : formatObjectiveList(r.data ?? [], r.metadata?.pagination);
    }
    case 'listKeyPerformanceIndicators': {
      const r = await client.listKeyPerformanceIndicators({ page: arg ? Number(arg) : 1 });
      return raw ? JSON.stringify(r, null, 2) : formatKpiList(r.data ?? [], r.metadata?.pagination);
    }
    case 'listKnowledgeBaseCategories': {
      const r = await client.listKnowledgeBaseCategories({ page: arg ? Number(arg) : 1 });
      return raw ? JSON.stringify(r, null, 2) : formatKnowledgeCategoryList(r.data ?? [], r.metadata?.pagination);
    }
    case 'listKnowledgeBaseArticles': {
      if (!arg) throw new Error('listKnowledgeBaseArticles needs a <categoryId>');
      const r = await client.listKnowledgeBaseArticles({ categoryId: arg });
      return raw ? JSON.stringify(r, null, 2) : formatKnowledgeArticleList(r.data ?? [], r.metadata?.pagination);
    }
    case 'getKnowledgeBaseArticle': {
      if (!arg) throw new Error('getKnowledgeBaseArticle needs an <articleId>');
      const r = await client.getKnowledgeBaseArticle(arg);
      return raw ? JSON.stringify(r, null, 2) : formatKnowledgeArticle(r.data);
    }
    default:
      throw new Error(
        `Unknown command "${command ?? ''}". Try: listEmployees | getEmployee <id> | listObjectives | ` +
          `listKeyPerformanceIndicators | listKnowledgeBaseCategories | listKnowledgeBaseArticles <categoryId> | ` +
          `getKnowledgeBaseArticle <articleId>  (prefix with "raw" to dump JSON)`,
      );
  }
}

run()
  .then((out) => console.log(out))
  .catch((err) => {
    console.error('ERROR:', err?.message ?? err);
    process.exit(1);
  });
