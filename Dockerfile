FROM nginx:alpine
COPY cli-acceptance/index.html /usr/share/nginx/html/index.html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
