const requiredSheetTabs = ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary'];
const optionalSheetTabs = ['Dashboard'];

function getMissingRequiredTabs(tabNames) {
  const present = new Set(tabNames || []);
  return requiredSheetTabs.filter(tab => !present.has(tab));
}

function buildSheetContractStatus(tabNames) {
  const present = new Set(tabNames || []);
  return {
    required: requiredSheetTabs.reduce((acc, tab) => {
      acc[tab] = present.has(tab);
      return acc;
    }, {}),
    optional: optionalSheetTabs.reduce((acc, tab) => {
      acc[tab] = present.has(tab);
      return acc;
    }, {}),
    missingRequiredTabs: getMissingRequiredTabs(tabNames)
  };
}

module.exports = {
  requiredSheetTabs,
  optionalSheetTabs,
  getMissingRequiredTabs,
  buildSheetContractStatus
};
