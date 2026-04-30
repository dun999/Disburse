import { assertMethod, readQueryString, sendError, sendJson, type ApiRequest, type ApiResponse } from "../server/http";
import { readRequestId, readStoredQrStatus } from "../server/qr";

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    assertMethod(request, "GET");
    sendJson(response, 200, await readStoredQrStatus(readRequestId(readQueryString(request, "id"))));
  } catch (error) {
    sendError(response, error);
  }
}
