using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Encore.Api.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class MemberPageAccess : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "pages",
                table: "users",
                type: "text",
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<string>(
                name: "pages",
                table: "invites",
                type: "text",
                nullable: false,
                defaultValue: "");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "pages",
                table: "users");

            migrationBuilder.DropColumn(
                name: "pages",
                table: "invites");
        }
    }
}
