// 指定ログイン情報 hydra_api_a 経由で GET /items を呼ぶ
//   sf apex run --target-org <your-org> --file m2m/salesforce/apex/get-items.apex
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:hydra_api_a/items');
req.setMethod('GET');
try {
    HttpResponse res = new Http().send(req);
    System.debug('RESULT status=' + res.getStatusCode() + ' body=' + res.getBody());
} catch (Exception e) {
    System.debug('RESULT exception=' + e.getTypeName() + ': ' + e.getMessage());
}
