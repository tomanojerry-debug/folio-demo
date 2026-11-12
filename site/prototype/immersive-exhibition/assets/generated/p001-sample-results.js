// Compatibility export for consumers of the original example route.
import { demoExtractions } from "../../fixtures.js";

export const p001SampleResults = Object.fromEntries(demoExtractions.map(item => [item.collectionId, item]));
