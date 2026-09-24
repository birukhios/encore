using Encore.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Encore.Api.Repositories;

public interface IReadinessRepository
{
    Task<bool> CanConnectAsync(CancellationToken cancellationToken);
}

public sealed class ReadinessRepository(EncoreIdentityDbContext db) : IReadinessRepository
{
    public Task<bool> CanConnectAsync(CancellationToken cancellationToken) =>
        db.Database.CanConnectAsync(cancellationToken);
}
