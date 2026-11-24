using Microsoft.Extensions.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

if (args[0] == "job-checks")
{
    await JobChecks.Run();
    return;
}

if (args[0] == "application-checks")
{
    await ApplicationChecks.Run();
    return;
}

if (args[0] == "retention-policy")
{
    var json = new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web);
    var row = System.Text.Json.JsonSerializer.Deserialize<HouseholdSubscription>(args[1], json)!;
    var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> {
        ["Retention:TrialDays"] = args[3], ["Retention:PaidDays"] = args[4],
    }).Build();
    Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(HouseholdRetentionPolicy.Calculate(row, DateTimeOffset.Parse(args[2]), configuration.GetSection("Retention").Get<FamilyBudget.Api.Infrastructure.Configuration.RetentionOptions>()), json));
    return;
}

// Runs the real generator at an explicit calendar date without adding a test clock or job endpoint to the API.
var options = new DbContextOptionsBuilder<BudgetDb>().UseSqlite($"Data Source={args[0]}").Options;
await using var db = new BudgetDb(options);
if (args.Length > 2 && args[2] == "upcoming")
{
    var upcoming = await UpcomingBills.ForHousehold(db, Guid.Parse(args[3]), DateOnly.Parse(args[1]));
    Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(upcoming, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)));
    return;
}
using var client = new HttpClient { BaseAddress = new Uri("https://api.frankfurter.dev/v2/providers/ecb/") };
var generator = new RecurringGenerator(db, new EcbRates(client), NullLogger<RecurringGenerator>.Instance);
await generator.Run(DateOnly.Parse(args[1]), CancellationToken.None);
