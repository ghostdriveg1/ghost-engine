{ pkgs, ... }: {
  packages = [
    pkgs.nodejs_20
    pkgs.git
  ];
  
  idx = {
    extensions = [
      "dbaeumer.vscode-eslint"
      "esbenp.prettier-vscode"
    ];
    
    workspace = {
      onCreate = {
        npm-install = "npm install";
      };
      onStart = {
        npm-start = "npm start";
      };
    };
  };
}
