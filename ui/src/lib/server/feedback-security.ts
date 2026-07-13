export function isSameOriginFeedbackRequest(request: Request, url: URL): boolean {
	return request.headers.get("origin") === url.origin
		&& (request.headers.get("sec-fetch-site") === null
			|| request.headers.get("sec-fetch-site") === "same-origin")
		&& request.headers.get("content-type")?.toLowerCase().startsWith("application/json") === true;
}
