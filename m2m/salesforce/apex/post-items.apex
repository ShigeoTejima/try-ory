// 指定ログイン情報 hydra_api_a 経由で POST /items を呼ぶ (api-a.write スコープが必要)
//   sf apex run --target-org <your-org> --file m2m/salesforce/apex/post-items.apex
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:hydra_api_a/items');
req.setMethod('POST');
req.setHeader('Content-Type', 'application/json');
req.setBody('{"name":"from salesforce"}');
try {
    HttpResponse res = new Http().send(req);
    System.debug('RESULT status=' + res.getStatusCode() + ' body=' + res.getBody());
} catch (Exception e) {
    System.debug('RESULT exception=' + e.getTypeName() + ': ' + e.getMessage());
}
