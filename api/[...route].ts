import type { ApiRequest, ApiResponse } from '../server-api/_http.js';
import cloudApi from '../server-api/cloud-api.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  return cloudApi(req, res);
}
