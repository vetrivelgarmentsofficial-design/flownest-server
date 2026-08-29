import { callGoogleApi } from './googleOAuth.service';
import { logger } from '../../utils/logger';

export interface SheetTab {
  name: string;
}

/**
 * Fetches all sheets/tabs inside a specific Google Spreadsheet.
 */
export async function fetchSpreadsheetTabs(spreadsheetId: string, accessToken: string): Promise<SheetTab[]> {
  logger.info('SpreadsheetService', 'Fetching spreadsheet properties/sheets list', { spreadsheetId });

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties&access_token=${accessToken}`;
  const response = await callGoogleApi(url, accessToken);

  const sheets = response.sheets || [];
  return sheets.map((sheet: any) => ({
    name: sheet.properties?.title || '',
  })).filter((tab: SheetTab) => tab.name !== '');
}

/**
 * Fetches spreadsheet name and list of tabs in a single API call.
 */
export async function fetchSpreadsheetMetadata(
  spreadsheetId: string,
  accessToken: string
): Promise<{ name: string; sheets: SheetTab[] }> {
  logger.info('SpreadsheetService', 'Fetching spreadsheet metadata', { spreadsheetId });

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=properties.title,sheets.properties.title&access_token=${accessToken}`;
  const response = await callGoogleApi(url, accessToken);

  const spreadsheetName = response.properties?.title || 'Untitled Spreadsheet';
  const sheets = (response.sheets || [])
    .map((sheet: any) => ({
      name: sheet.properties?.title || '',
    }))
    .filter((tab: SheetTab) => tab.name !== '');

  return {
    name: spreadsheetName,
    sheets,
  };
}

export async function fetchSheetValues(
  spreadsheetId: string,
  sheetTabName: string,
  accessToken: string,
  customRange?: string
): Promise<string[][]> {
  logger.info('SpreadsheetService', 'Fetching cell values from spreadsheet', {
    spreadsheetId,
    sheetTabName,
    customRange,
  });

  // Query dynamic range columns from the sheet. Escape single quotes and wrap in single quotes
  // so that sheet names with spaces or special characters parse correctly.
  const range = customRange || `'${sheetTabName.replace(/'/g, "''")}'!A:Z`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
    range
  )}?valueRenderOption=FORMATTED_VALUE&access_token=${accessToken}`;

  const response = await callGoogleApi(url, accessToken);
  return response.values || [];
}
