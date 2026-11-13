export const addressPattern = "(?:0[xX])?[0-9a-fA-F]{40}";
export const normalizeAddress = (value) => value.trim().replace(/^0x/i, "").toLowerCase();
