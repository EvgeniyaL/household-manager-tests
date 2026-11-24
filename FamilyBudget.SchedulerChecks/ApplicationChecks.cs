using FamilyBudget.Api.Features.Accounts;
using FamilyBudget.Api.Features.Currency;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FamilyBudget.Api.Features.Households;
using FamilyBudget.Api.Features.Recurring;
using FamilyBudget.Api.Features.Transactions;
using FamilyBudget.Api.Infrastructure.Authentication;
using FamilyBudget.Api.Infrastructure.Authorization;
using FamilyBudget.Api.Shared.Money;
using FamilyBudget.Api.Shared.Operations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

internal static class ApplicationChecks
{
    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
    private static void Throws<T>(Action action) where T : Exception
    {
        try { action(); }
        catch (T) { return; }
        throw new InvalidOperationException($"Expected {typeof(T).Name}");
    }
    public static async Task Run()
    {
        // Boundary amounts and half-cent rounding; the same rules serve manual,
        // recurring, and base-currency recalculation paths.
        Check(MoneyRules.Convert(1, 1.5m) == 2, "half cent rounds away from zero");
        Check(MoneyRules.Convert(1, 1.499999999999m) == 1, "below half cent stays down");
        Check(MoneyRules.Convert(5000, .9m) == 4500, "USD-to-EUR example");
        Check(MoneyRules.Convert(MoneyRules.MaximumMinor, 1) == MoneyRules.MaximumMinor, "maximum accepted");
        Throws<OverflowException>(() => MoneyRules.Convert(MoneyRules.MaximumMinor, 2));
        Throws<OverflowException>(() => MoneyRules.Convert(long.MaxValue, decimal.MaxValue));
        Throws<OverflowException>(() => MoneyRules.Convert(1, .01m));
        Check(MoneyRules.ConvertLimit(0, 1.2m) == 0, "zero budget limit is preserved");
        Throws<OverflowException>(() => MoneyRules.ConvertLimit(MoneyRules.MaximumMinor, 2));
        Check(MoneyRules.IsManualRate(.123456789012m) && !MoneyRules.IsManualRate(.1234567890123m), "manual precision boundary");
        Check(!MoneyRules.IsManualRate(0) && MoneyRules.IsManualRate(1000) && !MoneyRules.IsManualRate(1000.1m), "rate bounds");
        Check(MoneyRules.BaseCurrencyFactor("USD", "USD", 1.2m, .9m, "USD", "EUR") == 1, "manual original currency");
        Check(MoneyRules.BaseCurrencyFactor("USD", "EUR", .8m, .9m, "USD", "EUR") == .9m, "manual rate survives round trip");
        Check(MoneyRules.BaseCurrencyFactor("USD", "EUR", .8m, null, null, null) == .8m, "market conversion");
        Throws<InvalidOperationException>(() => MoneyRules.BaseCurrencyFactor("USD", "EUR", .8m, .9m, "EUR", "USD"));

        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var db = new BudgetDb(new DbContextOptionsBuilder<BudgetDb>().UseSqlite(connection).Options);
        await db.Database.EnsureCreatedAsync();
        var hasher = new PasswordHasher<Account>();
        var owner = new Account { Email = "owner@example.com", NormalizedEmail = "OWNER@EXAMPLE.COM" };
        owner.PasswordHash = hasher.HashPassword(owner, "Family-budget-123!");
        var member = new Account { Email = "member@example.com", NormalizedEmail = "MEMBER@EXAMPLE.COM" };
        var guest = new Account { Email = "guest@example.com", NormalizedEmail = "GUEST@EXAMPLE.COM" };
        guest.PasswordHash = hasher.HashPassword(guest, "Family-budget-123!");
        var household = new Household { Name = "Family", BaseCurrency = "EUR", Budget = new SharedBudget() };
        db.Accounts.AddRange(owner, member, guest);
        db.Households.Add(household);
        db.Memberships.AddRange(new HouseholdMembership { AccountId = owner.Id, Household = household, Role = "Owner" },
            new HouseholdMembership { AccountId = member.Id, Household = household, Role = "Member" });
        db.Categories.Add(new HouseholdCategory { HouseholdId = household.Id, Key = "Groceries", Type = "Expense" });
        var subscription = new HouseholdSubscription { HouseholdId = household.Id, TrialStartedAt = DateTimeOffset.UtcNow, TrialEndsAt = DateTimeOffset.UtcNow.AddDays(7) };
        db.HouseholdSubscriptions.Add(subscription);
        string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
        OperationActor Actor(Account account) => new(account.Id, Hash(account.Email));
        foreach (var account in new[] { owner, member, guest })
            db.Sessions.Add(new DeviceSession { AccountId = account.Id, TokenHash = Actor(account).SessionHash, ExpiresAt = DateTimeOffset.UtcNow.AddDays(30) });
        await db.SaveChangesAsync();

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(db);
        services.AddAuthorization(options =>
        {
            options.AddPolicy(HouseholdPolicies.Member, p => p.RequireAuthenticatedUser().AddRequirements(new HouseholdRequirement()));
            options.AddPolicy(HouseholdPolicies.Owner, p => p.RequireAuthenticatedUser().AddRequirements(new HouseholdRequirement(OwnerOnly: true)));
            options.AddPolicy(HouseholdPolicies.EditTransaction, p => p.RequireAuthenticatedUser().AddRequirements(new HouseholdRequirement(EditTransaction: true)));
        });
        services.AddScoped<IAuthorizationHandler, HouseholdAuthorizationHandler>();
        await using var provider = services.BuildServiceProvider();
        await using var scope = provider.CreateAsyncScope();
        // Deliberately no HTTP context/principal: operations authorize the explicit actor.
        var access = new HouseholdAccess(scope.ServiceProvider.GetRequiredService<IAuthorizationService>(), new HttpContextAccessor());
        using var client = new HttpClient(new NoNetwork()) { BaseAddress = new Uri("https://example.invalid/") };
        var rates = new EcbRates(client);
        var protection = new EphemeralDataProtectionProvider();
        var operations = new TransactionOperations(db, access, new ManualExchangeRates(db, rates, protection), rates);
        var input = new AddExpense(Guid.NewGuid(), 5000, "Groceries", new DateOnly(2024, 1, 1), "Shopping", "Member", "EUR");
        var created = await operations.Create(household.Id, input, Actor(member), false, default);
        Check(created.Status == OperationStatus.Created, "direct creation");
        var entry = (EntryResponse)created.Value!;
        Check(entry.AmountMinor == -5000 && entry.AuthorAccountId == member.Id, "signed cents and author");
        var replay = await operations.Create(household.Id, input, Actor(member), false, default);
        Check(replay.Status == OperationStatus.Success && await db.Entries.CountAsync() == 1, "creation receipt");
        var corrected = await operations.Change(household.Id, entry.Id,
            new EditEntry(entry.Revision, 6000, "Groceries", input.OccurredOn, "Corrected"), Actor(owner), false, default);
        Check(corrected.Status == OperationStatus.Success && ((EntryResponse)corrected.Value!).AuthorAccountId == member.Id, "owner correction preserves author");
        var forbidden = await operations.Change(household.Id, entry.Id,
            new EditEntry(entry.Revision, 7000, "Groceries", input.OccurredOn, "Wrong"), Actor(guest), false, default);
        Check(forbidden.Status == OperationStatus.Forbidden, "outsider cannot edit");
        var changed = (EntryResponse)corrected.Value!;
        var deleted = await operations.Change(household.Id, entry.Id, new EditEntry(changed.Revision, null, null, null, null), Actor(member), true, default);
        Check(deleted.Status == OperationStatus.NoContent, "author deletion");
        await operations.Create(household.Id, input, Actor(member), false, default);
        Check(await db.Entries.CountAsync() == 0, "retries do not recreate deleted entry");

        var recurring = new RecurringOperations(db, access);
        var ruleInput = new CreateRecurring(Guid.NewGuid(), 40000, "EUR", "Expense", "Groceries", "Monthly", new DateOnly(2024, 1, 31), 31);
        Check((await recurring.Create(household.Id, ruleInput, Actor(owner), default)).Status == OperationStatus.Created, "direct recurring creation");
        var rule = await db.RecurringRules.SingleAsync();
        var change = new ChangeRecurring(Guid.NewGuid(), rule.Revision, "amount", 45000);
        Check((await recurring.Change(household.Id, rule.Id, change, Actor(owner), default)).Status == OperationStatus.Success, "direct recurring change");
        Check((await recurring.Change(household.Id, rule.Id, change, Actor(owner), default)).SerializedValue is not null, "exact recurring response replay");

        const string code = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        db.Invites.Add(new HouseholdInvite { HouseholdId = household.Id, CreatedByAccountId = owner.Id, CodeHash = Hash(code), CreatedAt = DateTimeOffset.UtcNow, ExpiresAt = DateTimeOffset.UtcNow.AddHours(48) });
        await db.SaveChangesAsync();
        Check((await new InviteOperations(db).Redeem(new RedeemInvite(code), Actor(guest), default)).Status == OperationStatus.Success, "direct invite redemption");
        var privacy = new AccountPrivacyOperations(db, hasher);
        Check((await privacy.Delete(new AccountConfirmation("Family-budget-123!"), Actor(owner), default)).Status == OperationStatus.Conflict, "owner must select successor");
        Check((await privacy.Delete(new AccountConfirmation("Family-budget-123!"), Actor(guest), default)).Status == OperationStatus.NoContent, "direct account deletion");
        Check((await privacy.Export(new AccountConfirmation("Family-budget-123!"), Actor(guest), default)).Status == OperationStatus.Unauthenticated, "deleted session cannot export");

        var currency = new BaseCurrencyOperations(db, access, rates, protection);
        Check((await currency.Quote(household.Id, "USD", Actor(member), default)).Status == OperationStatus.Forbidden, "currency owner policy before IO");
        Check((await currency.Confirm(household.Id, new ConfirmBaseCurrency(Guid.NewGuid(), null), Actor(owner), default)).Status == OperationStatus.Invalid, "currency proof validation before IO");
        subscription.TrialEndsAt = DateTimeOffset.UtcNow.AddDays(-1);
        await db.SaveChangesAsync();
        Check((await operations.Create(household.Id, input with { Id = Guid.NewGuid() }, Actor(member), false, default)).Status == OperationStatus.SubscriptionRequired, "read-only writes blocked");
        Check((await privacy.Export(new AccountConfirmation("Family-budget-123!"), Actor(owner), default)).Status == OperationStatus.Success, "read-only export remains available");
        Console.WriteLine(JsonSerializer.Serialize(new { moneyRules = true, explicitActorOperations = true, retrySafety = true, privacyAndReadOnly = true }));
    }

    private sealed class NoNetwork : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("Unexpected external network request.");
    }
}
