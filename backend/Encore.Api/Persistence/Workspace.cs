using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Encore.Api.Persistence;

/// <summary>
/// The per-organization document stored in tenants.state (see domain.blank and domain.upgrade).
/// The collections are typed at the top level; their items stay JSON until each rule moves to a .NET service
/// and gets its own class. Unknown fields are carried through untouched, so a .NET save never drops data
/// the Python server still writes.
/// </summary>
public sealed class Workspace
{
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public string Currency { get; set; } = "ETB";
    public List<JsonObject> Events { get; set; } = [];
    public List<JsonObject> Tables { get; set; } = [];
    public List<JsonObject> Menu { get; set; } = [];
    public List<JsonObject> Orders { get; set; } = [];
    public List<JsonObject> Bookings { get; set; } = [];
    public List<JsonObject> Waiters { get; set; } = [];
    public List<JsonObject> StockLog { get; set; } = [];
    public List<JsonObject> Inventory { get; set; } = [];
    public JsonObject Settings { get; set; } = [];

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? Other { get; set; }

    public static Workspace Parse(string state) =>
        JsonSerializer.Deserialize<Workspace>(state, Json) ?? throw new InvalidDataException("The workspace document is empty.");

    public string Serialize() => JsonSerializer.Serialize(this, Json);
}
