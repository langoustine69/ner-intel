import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';

const agent = await createAgent({
  name: 'ner-intel',
  version: '1.0.0',
  description: 'Named Entity Recognition API - extract, classify, and link entities from text. Uses DBpedia Spotlight for NER and Wikidata for knowledge linking. B2A optimized for agents processing unstructured text.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch JSON with error handling ===
async function fetchJSON(url: string, options?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': 'ner-intel/1.0 (https://langoustine69.dev)',
      'Accept': 'application/json',
      ...options?.headers,
    }
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// === ENTITY TYPES MAPPING ===
const ENTITY_TYPES: Record<string, string> = {
  'Person': 'PERSON',
  'Organisation': 'ORG',
  'Organization': 'ORG',
  'Place': 'LOCATION',
  'Location': 'LOCATION',
  'Country': 'LOCATION',
  'City': 'LOCATION',
  'Company': 'ORG',
  'Work': 'WORK',
  'Event': 'EVENT',
  'Product': 'PRODUCT',
  'MeanOfTransportation': 'PRODUCT',
  'Automobile': 'PRODUCT',
  'Software': 'PRODUCT',
  'Species': 'SPECIES',
  'Disease': 'MEDICAL',
  'Drug': 'MEDICAL',
  'ChemicalSubstance': 'CHEMICAL',
};

function normalizeType(types: string): string[] {
  if (!types) return ['ENTITY'];
  const typeList = types.split(',').map(t => t.trim());
  const normalized = new Set<string>();
  
  for (const type of typeList) {
    const shortType = type.split(':').pop() || type;
    if (ENTITY_TYPES[shortType]) {
      normalized.add(ENTITY_TYPES[shortType]);
    }
  }
  
  return normalized.size > 0 ? Array.from(normalized) : ['ENTITY'];
}

// === DBpedia Spotlight NER ===
async function extractEntitiesDBpedia(text: string, confidence: number = 0.4): Promise<any[]> {
  try {
    const url = `https://api.dbpedia-spotlight.org/en/annotate?text=${encodeURIComponent(text)}&confidence=${confidence}`;
    const data = await fetchJSON(url);
    
    if (!data.Resources) return [];
    
    return data.Resources.map((r: any) => ({
      text: r['@surfaceForm'],
      offset: parseInt(r['@offset']),
      uri: r['@URI'],
      types: normalizeType(r['@types']),
      confidence: parseFloat(r['@similarityScore']),
      dbpediaUrl: r['@URI'],
    }));
  } catch (e) {
    return [];
  }
}

// === Wikidata entity search ===
async function searchWikidata(query: string, limit: number = 5, language: string = 'en'): Promise<any[]> {
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=${language}&format=json&limit=${limit}`;
  const data = await fetchJSON(url);
  
  return (data.search || []).map((item: any) => ({
    id: item.id,
    label: item.label,
    description: item.description || null,
    wikidataUrl: `https://www.wikidata.org/wiki/${item.id}`,
  }));
}

// === Wikidata entity details ===
async function getWikidataEntity(id: string, language: string = 'en'): Promise<any> {
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${id}&format=json&props=labels|descriptions|claims|sitelinks&languages=${language}`;
  const data = await fetchJSON(url);
  
  const entity = data.entities?.[id];
  if (!entity) return null;
  
  // Extract key properties
  const claims = entity.claims || {};
  const properties: Record<string, any> = {};
  
  // Instance of (P31)
  if (claims.P31) {
    properties.instanceOf = claims.P31.map((c: any) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
  }
  
  // Occupation (P106)
  if (claims.P106) {
    properties.occupation = claims.P106.map((c: any) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
  }
  
  // Country (P17)
  if (claims.P17) {
    properties.country = claims.P17[0]?.mainsnak?.datavalue?.value?.id;
  }
  
  // Inception/Founded (P571)
  if (claims.P571) {
    properties.inception = claims.P571[0]?.mainsnak?.datavalue?.value?.time;
  }
  
  // Date of birth (P569)
  if (claims.P569) {
    properties.dateOfBirth = claims.P569[0]?.mainsnak?.datavalue?.value?.time;
  }
  
  // Website (P856)
  if (claims.P856) {
    properties.website = claims.P856[0]?.mainsnak?.datavalue?.value;
  }
  
  return {
    id: entity.id,
    label: entity.labels?.[language]?.value || null,
    description: entity.descriptions?.[language]?.value || null,
    properties,
    wikipediaUrl: entity.sitelinks?.[`${language}wiki`]?.url || null,
    wikidataUrl: `https://www.wikidata.org/wiki/${id}`,
  };
}

// === Wikipedia summary ===
async function getWikipediaSummary(title: string, language: string = 'en'): Promise<any> {
  try {
    const url = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const data = await fetchJSON(url);
    return {
      title: data.title,
      description: data.description || null,
      extract: data.extract,
      thumbnail: data.thumbnail?.source || null,
      wikidataId: data.wikibase_item || null,
    };
  } catch (e) {
    return null;
  }
}

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of NER Intel capabilities - try before you buy',
  input: z.object({}),
  handler: async () => {
    return {
      output: {
        name: 'NER Intel',
        description: 'Named Entity Recognition API for extracting and linking entities from text',
        capabilities: [
          'Extract named entities (people, organizations, locations, products)',
          'Classify entities by type',
          'Link entities to knowledge bases (DBpedia, Wikidata, Wikipedia)',
          'Get detailed entity information',
          'Batch processing support',
        ],
        endpoints: {
          extract: { price: '$0.001', description: 'Extract entities from text' },
          annotate: { price: '$0.002', description: 'Extract + link entities with full metadata' },
          lookup: { price: '$0.002', description: 'Search for entity by name' },
          details: { price: '$0.003', description: 'Get comprehensive entity details' },
          analyze: { price: '$0.005', description: 'Full text analysis with stats' },
        },
        dataSource: 'DBpedia Spotlight + Wikidata (live)',
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID ENDPOINT 1 ($0.001): Extract entities ===
addEntrypoint({
  key: 'extract',
  description: 'Extract named entities from text with types',
  input: z.object({
    text: z.string().min(1).max(5000).describe('Text to extract entities from'),
    confidence: z.number().min(0).max(1).optional().default(0.4).describe('Confidence threshold (0-1)'),
  }),
  price: "1000",
  handler: async (ctx) => {
    const entities = await extractEntitiesDBpedia(ctx.input.text, ctx.input.confidence);
    
    return {
      output: {
        text: ctx.input.text.substring(0, 100) + (ctx.input.text.length > 100 ? '...' : ''),
        entityCount: entities.length,
        entities: entities.map(e => ({
          text: e.text,
          types: e.types,
          confidence: Math.round(e.confidence * 100) / 100,
        })),
        extractedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID ENDPOINT 2 ($0.002): Annotate with links ===
addEntrypoint({
  key: 'annotate',
  description: 'Extract entities and link them to knowledge bases',
  input: z.object({
    text: z.string().min(1).max(5000).describe('Text to annotate'),
    confidence: z.number().min(0).max(1).optional().default(0.4).describe('Confidence threshold'),
  }),
  price: "2000",
  handler: async (ctx) => {
    const entities = await extractEntitiesDBpedia(ctx.input.text, ctx.input.confidence);
    
    // Enrich with Wikipedia summaries for top entities
    const enriched = await Promise.all(
      entities.slice(0, 10).map(async (e) => {
        const label = e.dbpediaUrl.split('/').pop()?.replace(/_/g, ' ');
        const wiki = label ? await getWikipediaSummary(label) : null;
        return {
          ...e,
          wikipedia: wiki ? {
            title: wiki.title,
            description: wiki.description,
            extract: wiki.extract?.substring(0, 200),
            wikidataId: wiki.wikidataId,
          } : null,
        };
      })
    );
    
    return {
      output: {
        textLength: ctx.input.text.length,
        entityCount: enriched.length,
        entities: enriched,
        annotatedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID ENDPOINT 3 ($0.002): Lookup entity ===
addEntrypoint({
  key: 'lookup',
  description: 'Search for an entity by name in Wikidata',
  input: z.object({
    query: z.string().min(1).max(200).describe('Entity name to search for'),
    limit: z.number().min(1).max(20).optional().default(5).describe('Max results'),
    language: z.string().length(2).optional().default('en').describe('Language code'),
  }),
  price: "2000",
  handler: async (ctx) => {
    const results = await searchWikidata(ctx.input.query, ctx.input.limit, ctx.input.language);
    
    return {
      output: {
        query: ctx.input.query,
        resultCount: results.length,
        results,
        searchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID ENDPOINT 4 ($0.003): Entity details ===
addEntrypoint({
  key: 'details',
  description: 'Get comprehensive details about an entity from Wikidata',
  input: z.object({
    entityId: z.string().regex(/^Q\d+$/).describe('Wikidata entity ID (e.g., Q317521)'),
    language: z.string().length(2).optional().default('en').describe('Language code'),
  }),
  price: "3000",
  handler: async (ctx) => {
    const entity = await getWikidataEntity(ctx.input.entityId, ctx.input.language);
    
    if (!entity) {
      return { output: { error: 'Entity not found', entityId: ctx.input.entityId } };
    }
    
    // Get Wikipedia summary if available
    const wiki = entity.label ? await getWikipediaSummary(entity.label, ctx.input.language) : null;
    
    return {
      output: {
        ...entity,
        wikipedia: wiki ? {
          extract: wiki.extract,
          thumbnail: wiki.thumbnail,
        } : null,
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID ENDPOINT 5 ($0.005): Full text analysis ===
addEntrypoint({
  key: 'analyze',
  description: 'Comprehensive text analysis - entities, stats, and classifications',
  input: z.object({
    text: z.string().min(1).max(10000).describe('Text to analyze'),
    confidence: z.number().min(0).max(1).optional().default(0.35).describe('Confidence threshold'),
  }),
  price: "5000",
  handler: async (ctx) => {
    const entities = await extractEntitiesDBpedia(ctx.input.text, ctx.input.confidence);
    
    // Count by type
    const typeCounts: Record<string, number> = {};
    const uniqueEntities = new Set<string>();
    
    for (const e of entities) {
      uniqueEntities.add(e.text.toLowerCase());
      for (const type of e.types) {
        typeCounts[type] = (typeCounts[type] || 0) + 1;
      }
    }
    
    // Get details for top 5 unique entities
    const topEntities = entities.slice(0, 5);
    const enriched = await Promise.all(
      topEntities.map(async (e) => {
        const label = e.dbpediaUrl.split('/').pop()?.replace(/_/g, ' ');
        const wiki = label ? await getWikipediaSummary(label) : null;
        return {
          text: e.text,
          types: e.types,
          confidence: e.confidence,
          dbpediaUrl: e.dbpediaUrl,
          wikipedia: wiki ? {
            title: wiki.title,
            description: wiki.description,
            extract: wiki.extract?.substring(0, 300),
            thumbnail: wiki.thumbnail,
            wikidataId: wiki.wikidataId,
          } : null,
        };
      })
    );
    
    return {
      output: {
        stats: {
          textLength: ctx.input.text.length,
          wordCount: ctx.input.text.split(/\s+/).length,
          totalEntities: entities.length,
          uniqueEntities: uniqueEntities.size,
          typeCounts,
        },
        topEntities: enriched,
        allEntities: entities.map(e => ({
          text: e.text,
          types: e.types,
          offset: e.offset,
        })),
        analyzedAt: new Date().toISOString(),
      }
    };
  },
});

// === ANALYTICS ENDPOINTS (FREE) ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms')
  }),
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return { 
      output: { 
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      } 
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50)
  }),
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) return { output: { transactions: [] } };
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

addEntrypoint({
  key: 'analytics-csv',
  description: 'Export payment data as CSV',
  input: z.object({ windowMs: z.number().optional() }),
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) return { output: { csv: '' } };
    const csv = await exportToCSV(tracker, ctx.input.windowMs);
    return { output: { csv } };
  },
});

// === Serve icon ===
app.get('/icon.png', async (c) => {
  if (existsSync('./icon.png')) {
    const icon = readFileSync('./icon.png');
    return new Response(icon, { headers: { 'Content-Type': 'image/png' } });
  }
  return c.json({ error: 'Icon not found' }, 404);
});

// === ERC-8004 Registration File ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://ner-intel-production.up.railway.app';
  
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "ner-intel",
    description: "Named Entity Recognition API - extract, classify, and link entities from text using DBpedia Spotlight and Wikidata. B2A optimized for agents processing unstructured text. 1 free + 5 paid endpoints via x402.",
    image: `${baseUrl}/icon.png`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`NER Intel agent running on port ${port}`);

export default { port, fetch: app.fetch };
