/**
 * Extracts the spreadsheet ID from a Google Sheets URL.
 * Accepts: https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit...
 * Throws an error for invalid formats, non-Google URLs, or missing IDs.
 */
export function extractSpreadsheetId(url: string): string {
  if (!url) {
    throw new Error('Google Sheet URL is required.');
  }

  // Trim and clean URL
  const trimmedUrl = url.trim();

  // Basic Google Sheets domain validation
  if (!trimmedUrl.includes('docs.google.com/spreadsheets')) {
    throw new Error('Invalid URL. Must be a valid Google Sheets URL (docs.google.com/spreadsheets).');
  }

  // Regex to match the spreadsheet ID between /d/ and /edit (or similar slash/end of string)
  const regex = /\/spreadsheets\/d\/([a-zA-Z0-9-_]{15,100})/i;
  const match = trimmedUrl.match(regex);

  if (!match || !match[1]) {
    throw new Error('Could not extract a valid Google Spreadsheet ID from the provided link.');
  }

  return match[1];
}
