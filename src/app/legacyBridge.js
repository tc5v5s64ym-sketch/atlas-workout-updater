/* Atlas legacy bridge (temporary, Phase-1 PR-08).
 *
 * app.js is still the un-converted classic script (it becomes modules in PR-09).
 * It reads a handful of the now-ES-module helpers by reference off `window`
 * (the old UMD browser globals). Those modules no longer self-assign to `window`,
 * so this ONE file re-exposes them — the single, explicit seam app.js depends on.
 *
 * Each is spread into a plain object so the shape app.js sees is byte-identical
 * to the old UMD `root.X = exported` object (a mutable own-property bag), not a
 * frozen module namespace.
 *
 * This bridge shrinks in PR-09 and is deleted once app.js is fully modularised.
 */

import * as activeSession from './activeSession.js';
import * as planMutationIntent from './planMutationIntent.js';
import * as activeReplacement from './activeReplacement.js';
import * as identityCorrection from './identityCorrection.js';
import * as displayBlockNormalizer from './displayBlockNormalizer.js';
import * as hybridCompare from './hybridCompare.js';

window.activeSession = { ...activeSession };
window.planMutationIntent = { ...planMutationIntent };
window.activeReplacement = { ...activeReplacement };
window.identityCorrection = { ...identityCorrection };
window.displayBlockNormalizer = { ...displayBlockNormalizer };
window.hybridCompare = { ...hybridCompare };
