using System.Text.Json.Nodes;
using Encore.Api.Domain;
using Encore.Api.Persistence;

namespace Encore.Api.Tests;

/// <summary>The money rules from DomainTests in tests/test_server.py, stated in C#.</summary>
public sealed class PricingTests
{
    private static Workspace Concert(Action<JsonObject>? settings = null)
    {
        var s = Workspace.Parse("""
        {"name":"Concert Team","currency":"ETB",
         "menu":[{"id":"food","name":"Meal","price":10000,"available":true,"events":[]}],
         "events":[{"id":"event","name":"Concert","price":50000,"published":true,"capacity":2,"date":"2026-11-02T18:00"}],
         "tables":[{"id":"t","token":"unique-table","code":"ABCDEF","name":"Table 8","event":"event","seats":4,"status":"Available"}],
         "settings":{
          "ticketing":{"enabled":true,"maxPerOrder":6},
          "ordering":{"enabled":true,"requireScan":false,"ticketHoldersOnly":false,"eventMenus":true},
          "tips":{"enabled":true,"unit":"amount","presets":[20,50,100],"custom":true},
          "service":{"enabled":false,"rate":10},
          "tax":{"regime":"vat","vatRate":15,"pricesIncludeTax":false,"tin":"","vatNumber":"","tickets":true,"menu":true}}}
        """);
        settings?.Invoke(s.Settings);
        return s;
    }

    private static JsonObject Ask(string json) => JsonNode.Parse(json)!.AsObject();

    [Fact]
    public void Server_prices_and_table_context_ignore_the_browser_total()
    {
        var q = Pricing.QuoteOrder(Concert(), Ask("""{"kind":"menu","items":{"food":2},"table":"unique-table","tipAmount":"30","total":1}"""));
        // 200.00 food + 15% VAT (30.00) + 30.00 tip; the browser's "total": 1 is ignored.
        Assert.Equal((26000L, 3000L, "Table 8", 3000L, false),
            ((long)q["total"]!, (long)q["tip"]!, (string?)q["tableName"], (long)q["tax"]!["amount"]!, (bool)q["tax"]!["included"]!));
        Assert.Null(q["fee"]);
    }

    [Fact]
    public void Service_charge_is_taxed_and_tips_are_not()
    {
        var s = Concert(c => c["service"]!["enabled"] = true);
        var q = Pricing.QuoteOrder(s, Ask("""{"kind":"menu","items":{"food":1},"tipAmount":"5"}"""));
        // 100.00 items + 10.00 service + 15% VAT on 110.00 (16.50) + 5.00 tip = 131.50
        Assert.Equal((10000L, 1000L, 1650L, 500L, 13150L),
            ((long)q["subtotal"]!, (long)q["service"]!["amount"]!, (long)q["tax"]!["amount"]!, (long)q["tip"]!, (long)q["total"]!));
        Assert.Null(Pricing.QuoteOrder(s, Ask("""{"kind":"booking","event":"event","qty":1}"""))["service"]);
    }

    [Fact]
    public void Vat_inclusive_prices_are_not_charged_twice()
    {
        var q = Pricing.QuoteOrder(Concert(c => c["tax"]!["pricesIncludeTax"] = true), Ask("""{"kind":"menu","items":{"food":1}}"""));
        // 100.00 × 15/115 = 13.04 is already inside the price.
        Assert.Equal((1304L, 10000L), ((long)q["tax"]!["amount"]!, (long)q["total"]!));
    }

    [Theory]
    [InlineData("""{"kind":"menu","items":{"foreign-id":1}}""", "An item in your bag is no longer available.")]
    [InlineData("""{"kind":"menu","items":{"food":1},"table":"wrong"}""", "This table is not available for ordering.")]
    [InlineData("""{"kind":"booking","event":"event","qty":3}""", "There are not enough tickets available.")]
    [InlineData("""{"kind":"menu","items":{"food":1.5}}""", "Item quantities must be whole numbers.")]
    [InlineData("""{"kind":"menu","items":{"food":1},"tipAmount":"-5"}""", "Enter a tip between 0 and 50,000.")]
    public void Refuses_what_the_venue_cannot_sell(string request, string message) =>
        Assert.Equal(message, Assert.Throws<DomainException>(() => Pricing.QuoteOrder(Concert(), Ask(request))).Message);

    [Theory]
    [InlineData("0911 234 567"), InlineData("911234567"), InlineData("+251911234567"), InlineData("00251 911-234-567")]
    public void Ethiopian_numbers_normalize(string raw) => Assert.Equal("+251911234567", Values.NormalizePhone(raw));
}
