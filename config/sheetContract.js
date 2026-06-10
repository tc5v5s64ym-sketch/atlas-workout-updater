const requiredSheetTabs = ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary'];
const optionalSheetTabs = ['Dashboard'];

function getMissingRequiredTabs(availableTabs) {
  const available = new Set(availableTabs || []);
  return requiredSheetTabs.filter(tab => !available.has(tab));
}

function buildSheetContractStatus(availableTabs) {
  const available = new Set(availableTabs || []);
  return {
    tabs: Object.fromEntries(requiredSheetTabs.map(tab => [tab, { exists: available.has(tab) }])),
    optionalTabs: Object.fromEntries(optionalSheetTabs.map(tab => [tab, { exists: available.has(tab), required: false }])),
    missingRequiredTabs: getMissingRequiredTabs(availableTabs)
  };
}

module.exports = {
  requiredSheetTabs,
  optionalSheetTabs,
  getMissingRequiredTabs,
  buildSheetContractStatus
};
