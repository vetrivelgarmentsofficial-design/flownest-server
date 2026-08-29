import { callGoogleApi } from './googleOAuth.service';
import { logger } from '../../utils/logger';

export interface SpreadsheetFile {
  id: string;
  name: string;
}

/**
 * Fetches the list of accessible Google Spreadsheets for the user connection.
 */
export async function fetchUserSpreadsheets(accessToken: string): Promise<SpreadsheetFile[]> {
  logger.info('GoogleDriveService', 'Fetching spreadsheets list from Google Drive API');

  const query = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
  const fields = 'files(id, name)';
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
    query
  )}&fields=${encodeURIComponent(fields)}&pageSize=100`;

  const response = await callGoogleApi(url, accessToken);
  return response.files || [];
}
