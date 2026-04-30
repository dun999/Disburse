import { assertMethod, readJsonBody, sendError, sendJson, type ApiRequest, type ApiResponse } from "../server/http";
import { createStoredQrRequest } from "../server/qr";

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    assertMethod(request, "POST");
    sendJson(response, 201, await createStoredQrRequest(readJsonBody(request)));
  } catch (error) {
    sendError(response, error);
  }
}
