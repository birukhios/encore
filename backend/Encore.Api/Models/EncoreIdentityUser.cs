using Microsoft.AspNetCore.Identity;

namespace Encore.Api.Models;

public sealed class EncoreIdentityUser : IdentityUser
{
    public string TenantId { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string StaffRole { get; set; } = "";
}
